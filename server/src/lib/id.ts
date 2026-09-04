import { customAlphabet } from 'nanoid'

// 链接 ID 生成：'lk_' + 8 位 nanoid（字母表避开易混字符）
const nano8 = customAlphabet('0123456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', 8)

export function newLinkId(): string {
  return `lk_${nano8()}`
}

export function randomUuid(): string {
  // 浏览器/Node 均可用：crypto.randomUUID (Node ≥19)
  return crypto.randomUUID()
}
