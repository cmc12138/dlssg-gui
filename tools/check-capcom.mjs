/** 在上游仓库的 issue 与文档里找卡普空（RE Engine）相关的问题与解决办法 */
const API = 'https://api.github.com/repos/sdli1995/dlssg_for_sm86'
const H = { 'user-agent': 'dlssg-gui-research', accept: 'application/vnd.github+json' }

const KEYWORDS =
  /capcom|卡普空|resident evil|biohazard|re2|re3|re4|re7|re8|village|devil may cry|\bdmc\b|monster hunter|mhr|mhw|street fighter|dragon'?s dogma|exoprimal|pragmata|onimusha|RE Engine|防篡改|反篡改|白名单|完整性|anti-?tamper|denuvo/i

async function get(url) {
  for (let i = 1; i <= 3; i += 1) {
    try {
      const r = await fetch(url, { headers: H })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return await r.json()
    } catch (error) {
      if (i === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 800 * i))
    }
  }
}

const matches = []
for (let page = 1; page <= 3; page += 1) {
  const issues = await get(`${API}/issues?state=all&per_page=100&page=${page}`)
  if (!Array.isArray(issues) || issues.length === 0) break
  for (const issue of issues) {
    if (issue.pull_request) continue
    const text = `${issue.title}\n${issue.body ?? ''}`
    if (KEYWORDS.test(text)) {
      matches.push({
        number: issue.number,
        state: issue.state,
        title: issue.title,
        body: (issue.body ?? '').replace(/\r/g, '').slice(0, 1200),
        comments: issue.comments,
        url: issue.html_url
      })
    }
  }
}

console.log(`扫描了前 300 个 issue，命中卡普空/防篡改相关 ${matches.length} 个\n`)
for (const item of matches) {
  console.log(`#${item.number} [${item.state}] ${item.title}  （评论 ${item.comments}）`)
  console.log(item.body.split('\n').filter(Boolean).slice(0, 12).join('\n'))
  console.log(`  ${item.url}`)
  console.log('-'.repeat(90))
}

// 顺便把官方文档里跟"加载/白名单/签名/卸载"有关的段落抓出来
const token = process.env.GITHUB_TOKEN
const readme = await fetch('https://raw.githubusercontent.com/sdli1995/dlssg_for_sm86/main/docs/INSTALL.md', {
  headers: token ? { authorization: `Bearer ${token}` } : {}
})
const text = await readme.text()
console.log(`\n=== docs/INSTALL.md 里可能相关的段落（${text.length} 字节）===`)
const lines = text.split('\n')
lines.forEach((line, index) => {
  if (/白名单|签名|完整性|防篡改|反篡改|加载失败|启动失败|进不去|闪退|卡普空|Capcom|Denuvo|代理 DLL 的名字|换一个名字/i.test(line)) {
    console.log(`L${index + 1}: ${line.trim().slice(0, 300)}`)
  }
})
