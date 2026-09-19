/** 把几个卡普空相关 issue 的评论抓下来，看官方/用户给的解决办法 */
const API = 'https://api.github.com/repos/sdli1995/dlssg_for_sm86/issues'
const H = { 'user-agent': 'dlssg-gui-research', accept: 'application/vnd.github+json' }
const numbers = [40, 560, 538, 77, 19, 552]

async function get(url) {
  for (let i = 1; i <= 3; i += 1) {
    try {
      const r = await fetch(url, { headers: H })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return await r.json()
    } catch (error) {
      if (i === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 900 * i))
    }
  }
}

for (const number of numbers) {
  const issue = await get(`${API}/${number}`)
  console.log(`\n${'='.repeat(100)}`)
  console.log(`#${number} [${issue.state}] ${issue.title}`)
  console.log(`作者：${issue.user?.login}  标签：${(issue.labels ?? []).map((label) => label.name).join(',') || '无'}`)
  const body = (issue.body ?? '').replace(/\r/g, '').split('\n').filter(Boolean).slice(0, 8)
  console.log('正文：\n' + body.map((line) => '  ' + line.slice(0, 200)).join('\n'))
  const comments = await get(`${API}/${number}/comments?per_page=30`)
  for (const comment of comments) {
    const text = (comment.body ?? '').replace(/\r/g, '')
    console.log(`\n  ── ${comment.user?.login} (${comment.created_at?.slice(0, 10)}):`)
    console.log(
      text
        .split('\n')
        .filter(Boolean)
        .slice(0, 12)
        .map((line) => '    ' + line.slice(0, 220))
        .join('\n')
    )
  }
}
