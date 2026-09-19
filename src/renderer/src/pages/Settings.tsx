import type { JSX } from 'react'
import type { ProxyName } from '@shared/types'
import { KNOWN_PROXIES } from '@shared/types'
import { Alert, Button, Card, Field, Select, Toggle } from '../components/ui'
import { useApp } from '../state'

export function Settings(): JSX.Element {
  const app = useApp()
  const settings = app.settings

  if (!settings) {
    return (
      <div className="page">
        <p className="muted">读取设置中…</p>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h2>设置</h2>
          <p className="muted small">默认值与安全策略</p>
        </div>
      </header>

      <Card title="注入偏好">
        <div className="stack">
          <Field label="默认代理 DLL" hint="新建游戏条目与没有注入记录时使用">
            <Select
              value={settings.defaultProxy}
              onChange={(value: ProxyName) => void app.updateSettings({ defaultProxy: value })}
              options={KNOWN_PROXIES.map((name) => ({ value: name, label: name }))}
            />
          </Field>
          <Field label="默认运行库" hint="注入时预选的运行库">
            <Select
              value={settings.defaultPackageId ?? ''}
              onChange={(value) => void app.updateSettings({ defaultPackageId: value || undefined })}
              options={[{ value: '', label: '（不预设，用列表第一个）' }, ...app.packages.map((pkg) => ({ value: pkg.id, label: pkg.name }))]}
            />
          </Field>
          <Toggle
            checked={settings.confirmBeforeInstall}
            onChange={(value) => void app.updateSettings({ confirmBeforeInstall: value })}
            label="注入前二次确认"
            hint="建议保持开启"
          />
        </div>
      </Card>

      <Card title="备份与存储">
        <div className="stack">
          <Field label="每个游戏保留的备份份数" hint="超出后删除最旧的备份目录">
            <Select
              value={settings.keepBackups}
              onChange={(value) => void app.updateSettings({ keepBackups: Number(value) })}
              options={[1, 2, 3, 5, 10].map((count) => ({ value: count, label: `${count} 份` }))}
            />
          </Field>
          <div className="row">
            <Button onClick={() => void window.api.openPath(app.env?.dataDir ?? '')}>打开数据目录</Button>
            <Button variant="ghost" onClick={() => void app.refreshPackages()}>
              重新扫描运行库目录
            </Button>
          </div>
        </div>
      </Card>

      <Card title="下载">
        <div className="stack">
          <Toggle
            checked={settings.downloadAllProxies}
            onChange={(value) => void app.updateSettings({ downloadAllProxies: value })}
            label="连其它代理名一起下载"
            hint="关闭（推荐）只下 version.dll，约 30MB；打开会额外下 winmm/dbghelp/dinput8/dxgi/d3d12，总共约 180MB。只有游戏不加载 version.dll 时才需要备选代理名"
          />
          <Toggle
            checked={settings.preferMirror}
            onChange={(value) => void app.updateSettings({ preferMirror: value })}
            label="优先使用镜像加速"
            hint="先试 raw.gitmirror.com（这个域名在你所在网络不一定能解析），失败自动回退官方地址；两条直链都失败时还有 GitHub API 兜底通道"
          />
          <p className="muted small">
            下载体积参考：上游 0.3.4 的主分支发布包，version.dll 约 28.6MB，每个备选代理也是这个量级，出厂 ini 只有几 KB。
          </p>
        </div>
      </Card>

      <Card title="使用须知" tone="warn">
        <ul className="list">
          <li>本工具不包含、也不修改上游的 DLL，只做「复制 + 写配置 + 备份还原」。</li>
          <li>注入等同于 MOD：游戏完整性校验可能失败，联网游戏/反作弊游戏不要使用。</li>
          <li>升级上游版本后，用新版运行库重新注入即可，配置会保留。</li>
          <li>数据目录：{app.env?.dataDir}（可用 portable.txt 切换为便携模式，数据放在 exe 旁的 data 目录）。</li>
        </ul>
      </Card>

      <Alert tone="info" title="卸载">
        先在每个游戏里点「一键还原」，再删除本软件目录与数据目录即可，不会留下对游戏目录的改动。
      </Alert>
    </div>
  )
}
