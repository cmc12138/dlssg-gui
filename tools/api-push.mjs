/**
 * 在 github.com:443 被墙 / 被重置、但 api.github.com 可用时，用 Git 数据 API 把本地提交推上去。
 *
 * 原理：把本地 commit 的树原样重建到远端 —— 逐个上传 blob（内容取自本地对象库，因此 blob sha 一致），
 * 用 base_tree 建树，再建 commit，最后移动分支引用。因为 parent / tree / author / committer / message
 * 都与本地一致，生成的 commit sha 与本地完全相同，远端和本地不会分叉。
 *
 * 用法：node tools/api-push.mjs [远端名] [分支]
 * 需要 gh 已登录（读取 gh auth token）。
 */
import { execFileSync } from 'node:child_process'

const REMOTE = process.argv[2] ?? 'origin'
const BRANCH = process.argv[3] ?? 'main'

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: options.binary ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024, ...options })
}

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
if (!token) throw new Error('拿不到 gh 的 token，先 gh auth login')

const remoteUrl = git(['remote', 'get-url', REMOTE]).trim()
const repoMatch = /github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/.exec(remoteUrl)
if (!repoMatch) throw new Error(`无法从远端地址解析仓库：${remoteUrl}`)
const [, owner, repo] = repoMatch
const api = `https://api.github.com/repos/${owner}/${repo}`

async function apiCall(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dlssg-gui-api-push',
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${response.status}\n${text.slice(0, 600)}`)
  return text ? JSON.parse(text) : {}
}

const localSha = git(['rev-parse', BRANCH]).trim()
const parentSha = git(['rev-parse', `${BRANCH}~1`]).trim()
const localTree = git(['rev-parse', `${BRANCH}^{tree}`]).trim()

const ref = await apiCall(`/git/ref/heads/${BRANCH}`)
const remoteHead = ref.object.sha
console.log(`远端 ${owner}/${repo}@${BRANCH} = ${remoteHead.slice(0, 10)}`)
console.log(`本地 ${BRANCH} = ${localSha.slice(0, 10)}（parent ${parentSha.slice(0, 10)}）`)
if (remoteHead === localSha) {
  console.log('远端已经是这个提交，无需推送')
  process.exit(0)
}
if (remoteHead !== parentSha) {
  throw new Error('远端 HEAD 不是本地提交的父提交，两边已经分叉，请改用 git push / git pull 处理')
}

const status = git(['diff-tree', '-r', '-z', '--name-status', '--no-renames', parentSha, localSha])
  .split('\0')
  .filter(Boolean)
const entries = []
let uploaded = 0
for (let i = 0; i < status.length; i += 2) {
  const code = status[i]
  const path = status[i + 1]
  if (code === 'D') {
    entries.push({ path, mode: '100644', type: 'blob', sha: null })
    console.log(`  删除 ${path}`)
    continue
  }
  const blobSha = git(['rev-parse', `${localSha}:${path}`]).trim()
  const content = git(['cat-file', 'blob', blobSha], { binary: true })
  const created = await apiCall('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' })
  })
  if (created.sha !== blobSha) throw new Error(`blob 校验失败：${path} 本地 ${blobSha} 远端 ${created.sha}`)
  entries.push({ path, mode: '100644', type: 'blob', sha: created.sha })
  uploaded += 1
  console.log(`  ${code === 'A' ? '新增' : '修改'} ${path}（${(content.length / 1024).toFixed(1)} KB）`)
}

const tree = await apiCall('/git/trees', {
  method: 'POST',
  body: JSON.stringify({ base_tree: git(['rev-parse', `${parentSha}^{tree}`]).trim(), tree: entries })
})
if (tree.sha !== localTree) throw new Error(`树校验失败：本地 ${localTree} 远端 ${tree.sha}`)

const meta = git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', localSha]).split('\0')
const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = meta
// 关键：message 必须原样取本地 commit 对象里的字节（含 git 的那个结尾换行），
// GitHub 写对象时不补也不删换行，只有这样生成的 commit 才和本地逐字节一致（sha 相同）。
const rawCommit = git(['cat-file', 'commit', localSha])
const message = rawCommit.slice(rawCommit.indexOf('\n\n') + 2)

const commit = await apiCall('/git/commits', {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: tree.sha,
    parents: [parentSha],
    author: { name: authorName, email: authorEmail, date: authorDate },
    committer: { name: committerName, email: committerEmail, date: committerDate }
  })
})
console.log(`远端提交 = ${commit.sha.slice(0, 10)}（本地 ${localSha.slice(0, 10)}）`)
if (commit.sha !== localSha) {
  // 兜底：万一 sha 不同（GitHub 侧改写了什么），就把远端 commit 原样在本地重建，
  // 让引用能指过去，本地/远端不会分叉。
  console.warn('生成的 commit sha 与本地不同，正在本地重建该对象以保持一致…')
  const created = await apiCall(`/git/commits/${commit.sha}`)
  const offset = (iso) => {
    const match = /([+-])(\d{2}):(\d{2})$/.exec(iso)
    return match ? `${match[1]}${match[2]}${match[3]}` : '+0000'
  }
  const rebuilt = [
    `tree ${created.tree.sha}`,
    ...created.parents.map((parent) => `parent ${parent.sha}`),
    `author ${created.author.name} <${created.author.email}> ${Math.floor(new Date(created.author.date).getTime() / 1000)} ${offset(authorDate)}`,
    `committer ${created.committer.name} <${created.committer.email}> ${Math.floor(new Date(created.committer.date).getTime() / 1000)} ${offset(committerDate)}`,
    '',
    created.message
  ].join('\n')
  const rebuiltSha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: rebuilt, encoding: 'utf8' }).trim()
  if (rebuiltSha !== commit.sha) {
    console.warn('本地重建的 sha 与远端不一致，跳过；等 github.com 通了用 git fetch && git reset --soft origin/main 对齐')
  } else {
    git(['update-ref', `refs/heads/${BRANCH}`, rebuiltSha])
  }
}

await apiCall(`/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false })
})
// 让本地跟踪引用反映现实（github.com 不通时 fetch 用不了）
try {
  git(['update-ref', `refs/remotes/${REMOTE}/${BRANCH}`, commit.sha])
} catch (error) {
  console.warn('更新本地远程跟踪引用失败：', String(error).slice(0, 200))
}
console.log(`完成：上传 ${uploaded} 个 blob，分支 ${BRANCH} → ${commit.sha}`)
