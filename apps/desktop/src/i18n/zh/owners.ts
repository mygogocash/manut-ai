import type { owners as en } from "../en/owners";

export const owners: Record<keyof typeof en, string> = {
  "owners.title": "只有 {owner} 能看到这里",
  "owners.theOwner": "店主",
  "owners.team": "你在 {shop} 当帮手。它的团队、每位成员在做的事和全员暂停都属于 {owner}。等你处理的请求在“需要你处理”里。",
  "owners.history": "你在 {shop} 当帮手。它过去的工作只有 {owner} 能看到。等你处理的请求在“需要你处理”里。",
  "owners.activity": "你在 {shop} 当帮手。它的活动记录只有 {owner} 能看到。等你处理的请求在“需要你处理”里。",
  "owners.automations": "你在 {shop} 当帮手。它的定时任务只有 {owner} 能查看和更改。等你处理的请求在“需要你处理”里。",
  "owners.working": "只有 {owner} 能看到 {shop} 现在谁在工作。",
  "owners.toNeeds": "打开“需要你处理”",
};
