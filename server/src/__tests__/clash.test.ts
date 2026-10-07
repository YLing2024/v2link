import { describe, expect, it } from 'vitest'
import {
  CLASH_GROUP_NAME,
  buildClashConfig,
  dedupeNodeNames,
  type ClashNode,
} from '../lib/clash.js'

// lib/clash.ts 单测：结构、别名去重、特殊字符别名不破 YAML、节点顺序。
// 不引 YAML 解析器（仓库禁新依赖）：用行级断言 + JSON.parse 校验被引号包裹的标量。

function node(over: Partial<ClashNode> = {}): ClashNode {
  return {
    uuid: '11111111-1111-4111-8111-111111111111',
    name: '节点A',
    server: 'v2.example.com',
    sni: 'v2.example.com',
    ...over,
  }
}

/** 取出 proxies 段（proxy-groups 之前）里 `- name:` 行的标量并 JSON.parse（即真实节点名） */
function proxyNames(yaml: string): string[] {
  const out: string[] = []
  for (const line of yaml.split('\nproxy-groups:')[0]!.split('\n')) {
    const m = /^ {2}- name: (.*)$/.exec(line)
    if (m && m[1] !== undefined) out.push(JSON.parse(m[1]) as string)
  }
  return out
}

/** 取出 proxy-groups.proxies 列表里的标量 */
function groupRefs(yaml: string): string[] {
  const out: string[] = []
  let inRefs = false
  for (const line of yaml.split('\n')) {
    if (/^ {4}proxies:$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs) {
      const m = /^ {6}- (.*)$/.exec(line)
      if (!m || m[1] === undefined) break
      out.push(JSON.parse(m[1]) as string)
    }
  }
  return out
}

describe('dedupeNodeNames', () => {
  it('重名追加 #2/#3，保持顺序，首名不变', () => {
    expect(dedupeNodeNames(['a', 'a', 'a'])).toEqual(['a', 'a#2', 'a#3'])
    expect(dedupeNodeNames(['a', 'b', 'a', 'b', 'a'])).toEqual(['a', 'b', 'a#2', 'b#2', 'a#3'])
  })

  it('去重结果全局唯一：不会与新名撞车', () => {
    const names = dedupeNodeNames(['a', 'a', 'a#2'])
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(['a', 'a#2', 'a#2#2'])
  })
})

describe('buildClashConfig', () => {
  it('生成 vless + ws 的标准结构', () => {
    const yaml = buildClashConfig([node()])
    expect(yaml).toContain('proxies:')
    expect(yaml).toContain('    type: vless')
    expect(yaml).toContain('    server: "v2.example.com"')
    expect(yaml).toContain('    port: 443')
    expect(yaml).toContain('    uuid: "11111111-1111-4111-8111-111111111111"')
    expect(yaml).toContain('    udp: true')
    expect(yaml).toContain('    tls: true')
    expect(yaml).toContain('    servername: "v2.example.com"')
    expect(yaml).toContain('    network: ws')
    expect(yaml).toContain('      path: "/v2ws"')
    expect(yaml).toContain('        Host: "v2.example.com"')
    expect(yaml).toContain('proxy-groups:')
    expect(yaml).toContain(`  - name: ${JSON.stringify(CLASH_GROUP_NAME)}`)
    expect(yaml).toContain('    type: select')
    expect(yaml).toContain('rules:')
    expect(yaml).toContain(`  - ${JSON.stringify(`MATCH,${CLASH_GROUP_NAME}`)}`)
  })

  it('sni 为空回退 server；path/port 可覆盖', () => {
    const yaml = buildClashConfig([node({ sni: '', port: 8443, path: '/custom' })])
    expect(yaml).toContain('    servername: "v2.example.com"')
    expect(yaml).toContain('        Host: "v2.example.com"')
    expect(yaml).toContain('    port: 8443')
    expect(yaml).toContain('      path: "/custom"')
  })

  it('代理名与组引用一致，重名自动 #2', () => {
    const yaml = buildClashConfig([node({ name: '重名' }), node({ name: '重名' })])
    expect(proxyNames(yaml)).toEqual(['重名', '重名#2'])
    expect(groupRefs(yaml)).toEqual(['重名', '重名#2'])
  })

  it('节点顺序 = 传入顺序', () => {
    const yaml = buildClashConfig([node({ name: '第一' }), node({ name: '第二' })])
    expect(proxyNames(yaml)).toEqual(['第一', '第二'])
    expect(groupRefs(yaml)).toEqual(['第一', '第二'])
  })

  it('特殊字符别名不破 YAML（冒号/井号/引号/反斜杠/换行/中文/emoji）', () => {
    const evil = 'a: b #c "d" \\ 中文 😀\n    type: evil'
    const yaml = buildClashConfig([node({ name: evil })])
    // 名字被完整包进一个双引号标量；反解析回去等于原值
    expect(proxyNames(yaml)).toEqual([evil])
    expect(groupRefs(yaml)).toEqual([evil])
    // 换行被转义，注入的假配置行不会真正出现
    expect(yaml.split('\n')).not.toContain('    type: evil')
    expect(yaml).toContain(`  - name: ${JSON.stringify(evil)}`)
  })

  it('零节点：proxies/组引用为空列表，rules 仍在', () => {
    const yaml = buildClashConfig([])
    expect(yaml).toContain('proxies: []')
    expect(yaml).toContain('    proxies: []')
    expect(yaml).toContain(`  - ${JSON.stringify(`MATCH,${CLASH_GROUP_NAME}`)}`)
    expect(proxyNames(yaml)).toEqual([])
  })
})
