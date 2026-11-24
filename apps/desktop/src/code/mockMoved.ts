// What the mock host answers for the main branch moving (MockHost.mainMoved in src/sessions/host.ts), so the state can be
// seen in a browser, where there is no shell to run git. It is the canvas's project: the lane kit/promptpay-qr changed
// three files while main changed README.md and src/checkout.tsx, so one file needs both changes. A spec swaps it with
// `window.__manutMoved`.
import type { GitView } from "./moved";

export const MOCK_MOVED_ROOT = "/home/you/code/baanmali-preorder";

const CHECKOUT_THEIRS = [
  "diff --git a/src/checkout.tsx b/src/checkout.tsx",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/checkout.tsx",
  "+++ b/src/checkout.tsx",
  "@@ -12,5 +12,6 @@ export function Checkout({ order }: Props) {",
  " export function Checkout({ order }: Props) {",
  "-  const total = order.items.reduce(sum, 0);",
  "+  const total = order.items.reduce(sum, 0) + shipping(order);",
  "+  const note = t(\"checkout.shippingIncluded\");",
  "   return <PayByTransfer amount={total} />;",
  " }",
  "",
].join("\n");

const CHECKOUT_OURS = [
  "diff --git a/src/checkout.tsx b/src/checkout.tsx",
  "index 1a2b3c4..9f8e7d6 100644",
  "--- a/src/checkout.tsx",
  "+++ b/src/checkout.tsx",
  "@@ -12,5 +12,11 @@ export function Checkout({ order }: Props) {",
  " export function Checkout({ order }: Props) {",
  "   const total = order.items.reduce(sum, 0);",
  "-  return <PayByTransfer amount={total} />;",
  "+  const qr = promptPayQR(SHOP_ID, total);",
  "+  return (",
  "+    <PayPanel amount={total}>",
  "+      <QRCode value={qr} label=\"Scan to pay\" />",
  "+    </PayPanel>",
  "+  );",
  " }",
  "",
].join("\n");

export const MOCK_MOVED: GitView = {
  branch: "kit/promptpay-qr",
  base: "main",
  tip: "b3c5d7e9f1a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0",
  fork: "a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7",
  ours: ["src/checkout.tsx", "src/promptpay.ts", "tests/checkout.test.ts"],
  theirs: ["README.md", "src/checkout.tsx"],
  both: [{ path: "src/checkout.tsx", theirs: CHECKOUT_THEIRS, ours: CHECKOUT_OURS }],
};
