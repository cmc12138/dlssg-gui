import { useEffect, useRef, useState, type ReactNode, type CSSProperties, type JSX } from 'react'

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  size = 'md',
  title,
  style
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  size?: 'sm' | 'md'
  title?: string
  style?: CSSProperties
}): JSX.Element {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={style}
    >
      {children}
    </button>
  )
}

export function Card({
  title,
  subtitle,
  children,
  actions,
  tone
}: {
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  actions?: ReactNode
  tone?: 'default' | 'warn' | 'bad'
}): JSX.Element {
  return (
    <section className={`card${tone && tone !== 'default' ? ` card-${tone}` : ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  )
}

export function Badge({
  children,
  tone = 'muted'
}: {
  children: ReactNode
  tone?: 'ok' | 'warn' | 'bad' | 'muted' | 'info'
}): JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Field({
  label,
  hint,
  children,
  inline
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  inline?: boolean
}): JSX.Element {
  return (
    <label className={`field${inline ? ' field-inline' : ''}`}>
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <input
      className="input"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  disabled
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  disabled?: boolean
}): JSX.Element {
  return (
    <input
      className="input input-number"
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) onChange(next)
      }}
    />
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <select
      className="input"
      value={String(value)}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value
        const found = options.find((option) => String(option.value) === raw)
        if (found) onChange(found.value)
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  )
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label?: string }): JSX.Element {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${percent}%` }} />
      <span className="progress-text">
        {label ? `${label} · ` : ''}
        {percent}%
      </span>
    </div>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="muted small">{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 560
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === ref.current && onClose()}>
      <div className="modal" style={{ width }} ref={ref}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className="tabs">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`tab${option.value === value ? ' tab-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Alert({
  tone = 'info',
  title,
  children
}: {
  tone?: 'info' | 'warn' | 'bad' | 'ok'
  title?: ReactNode
  children?: ReactNode
}): JSX.Element {
  return (
    <div className={`alert alert-${tone}`}>
      {title && <strong>{title}</strong>}
      {children && <div className="alert-body">{children}</div>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span className="spinner-wrap">
      <span className="spinner" />
      {label && <span className="muted small">{label}</span>}
    </span>
  )
}

export function useToasts(): {
  toasts: { id: number; message: string; tone: 'ok' | 'bad' | 'info' }[]
  push: (message: string, tone?: 'ok' | 'bad' | 'info') => void
} {
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: 'ok' | 'bad' | 'info' }[]>([])
  const counter = useRef(0)
  const push = (message: string, tone: 'ok' | 'bad' | 'info' = 'info'): void => {
    counter.current += 1
    const id = counter.current
    setToasts((list) => [...list, { id, message, tone }])
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), tone === 'bad' ? 9000 : 5000)
  }
  return { toasts, push }
}

export function ToastStack({
  toasts
}: {
  toasts: { id: number; message: string; tone: 'ok' | 'bad' | 'info' }[]
}): JSX.Element {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          {toast.message}
        </div>
      ))}
    </div>
  )
}
