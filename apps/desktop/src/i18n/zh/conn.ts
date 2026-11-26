import type { conn as en } from "../en/conn";

export const conn: Record<keyof typeof en, string> = {
  "conn.save": "保存",
  "conn.saving": "正在保存…",
  "conn.cancel": "取消",
  "conn.err.ownerOnly": "只有店主才能查看和更改登录与前哨。",
  "conn.err.noShop": "你的账户还没有关联任何店铺，所以这里没有可管理的登录与前哨。",
  "conn.err.password": "密码为 1 到 {max} 个字符。",
  "conn.err.signInGone": "该登录已不在保险库中。",
  "conn.err.name": "名称为 1 到 {max} 个字符。",
  "conn.err.outpostGone": "该前哨已不属于你的店铺。",
  "conn.err.unavailable": "保险库没有响应。请重试。",
  "conn.err.again": "没有保存任何内容。要再试一次，请重新输入密码。",
  "conn.err.failed": "没有成功。请重试。",
  "conn.err.site": "网站名称为 1 到 {max} 个字符。",
  "conn.err.origins": "请添加 1 到 {max} 个这个网站自己的地址，每个都以 https:// 开头。",
  "conn.err.username": "账户名为 1 到 {max} 个字符。",
  "conn.err.members": "请选择谁可以使用：Nam、Pim、Ton、Kit 中的一人或多人。",
  "conn.err.tooMany": "你的店铺已有 {max} 个登录，这是保险库能保存的上限。请让运营人员删除一个。",
  "conn.err.vaultKey": "保险库还没准备好，所以没有保存任何内容。请让运营人员设置。",
  "conn.err.noChange": "没有任何变化：这就是它现在的账户和地址。",
  "conn.err.passwordAgain": "请重新输入密码：新的账户或新的地址需要它，这样保险库就不会把已保存的密码输入到新的地方。",
};
