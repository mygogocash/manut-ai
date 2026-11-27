export const buddy = {
  // Buddy in Practice: Buddy answers through the coding agent on this computer, with the person's own sign-in (src/runtime/mock/buddy.ts)
  "buddy.hello": "Hi, I'm Buddy. In Practice the shop, its orders and its team are a sample, and nothing here reaches a real customer.\n\nI answer through a coding agent you already have on this computer, such as Claude Code, signed in with your own account, and I ask you before I change or send anything. Try `/approve`, `/clarify`, `/interview` and `/delegate` to see how the team asks before it acts.",
  "buddy.anyAgent": "Your coding agent",
  "buddy.noAgent": "No coding agent",
  "buddy.none": "I answer through a coding agent on this computer, signed in with your own account, and none I can use is installed yet. Claude Code works: its install line is in the Code page's + menu, under More agents. Once it is installed, run {cmd} in a terminal to sign in, then send your message again.",
  "buddy.notYet": "{agents} is on this computer, but I cannot answer through it yet.",
  "buddy.signedOut": "{agent} is not signed in, so I cannot answer yet. Run {cmd} in a terminal and sign in, then send your message again.",
  "buddy.old": "{agent} on this computer is too old to answer as Buddy. Update it with {cmd}, then send your message again.",
  "buddy.failed": "{agent} could not answer this time. It said: {why}\n\nSend your message again to try once more.",
  "buddy.stopped": "{agent} stopped before it answered. Send your message again to try once more.",
  "buddy.off": "{agent} is turned off in Settings › Providers, so I cannot answer. Turn it on there, then send your message again.",
};
