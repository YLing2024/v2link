// 到期语义单点定义：expires_at === 0 表示「永久有效」（永不自动过期）。
//
// 为什么用哨兵值而不是 NULL / 新增布尔列：
//   · 列定义为 `expires_at INTEGER NOT NULL`，改 NULL 要重建表（SQLite 改列约束），代价大；
//   · 新增 permanent 列会引入两个事实来源（permanent=1 时 expires_at 无意义），易不一致；
//   · 哨兵 0 单字段即可表达，无 schema 迁移，读取侧统一走 isPermanentExpiry()。
// 污染面控制：所有「比较/展示 expires_at」的地方必须过这两个函数，禁止裸写 `=== 0`。
export const PERMANENT_EXPIRES_AT = 0

/** 是否永久有效（expires_at 为哨兵 0） */
export function isPermanentExpiry(expiresAt: number): boolean {
  return Number(expiresAt) === PERMANENT_EXPIRES_AT
}
