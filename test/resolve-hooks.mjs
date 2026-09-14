import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

/**
 * 开发期测试用的解析钩子：把 @shared/* 别名与无扩展名的相对导入
 * 解析到 src 下的 .ts 文件，这样测试可以直接跑源码（不经过打包器）。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@shared/')) {
    const url = new URL(`src/shared/${specifier.slice('@shared/'.length)}.ts`, root)
    return { url: url.href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const candidate = new URL(specifier + suffix, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}
