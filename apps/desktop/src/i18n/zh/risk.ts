import type { risk as en } from "../en/risk";

export const risk: Record<keyof typeof en, string> = {
  "risk.delete": "会删除文件和文件夹",
  "risk.admin": "以管理员权限运行",
  "risk.force": "会改写远程分支的历史",
  "risk.discard": "会丢弃本地改动",
  "risk.erase": "会抹掉磁盘",
  "risk.rawDisk": "直接写入磁盘",
  "risk.perms": "大范围修改权限",
  "risk.db": "会删除数据库数据",
  "risk.pipe": "运行从网上下载的脚本",
  "risk.infra": "会删除线上基础设施",
  "risk.forkBomb": "fork 炸弹",
};
