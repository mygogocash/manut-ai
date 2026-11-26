// A computer use card in the person's language (item 82): the shell names what will be done and exactly where and with
// what (`tool.computer`, src-tauri/src/computer/room.rs), and this puts it in words. The title says the act; the lines
// say the app, the window, the control, the keys or the menu item, and the text to type whole, nothing cut or masked,
// since what is allowed must be exactly what is done. Typing into a field that holds anything replaces all of it (item
// 92), so that card says "Replace everything" and how many characters the field holds. The shell's own English words
// stay on the ask for anything that reads them.
import { t } from "../../i18n";
import type { ComputerAsk } from "../../lib/protocol";

export interface ComputerWords {
  title: string;
  lines: string;
}

export function computerWords(c: ComputerAsk): ComputerWords {
  const app = c.app;
  const menu = (c.menu ?? []).join(" › ");
  const title =
    c.act === "look"
      ? t("computer.ask.look", { app })
      : c.act === "click"
        ? t("computer.ask.click", { control: c.control ?? "", app })
        : c.act === "set"
          ? t("computer.ask.set", { control: c.control ?? "", app })
          : c.act === "replace"
            ? t(c.replaces === 1 ? "computer.ask.replaceOne" : "computer.ask.replace", { control: c.control ?? "", n: String(c.replaces ?? 0), app })
            : c.act === "key"
            ? t("computer.ask.key", { keys: c.keys ?? "", app })
            : t("computer.ask.menu", { menu, app });
  const lines = [t("computer.ask.app", { app })];
  if (c.window !== undefined) lines.push(t("computer.ask.window", { window: c.window }));
  if (c.control !== undefined) lines.push(t("computer.ask.control", { control: c.control }));
  // the control's name is the app's own words (a web page names its controls as it likes): the card says so
  if (c.act === "click" || c.act === "set" || c.act === "replace") lines.push(t("computer.ask.named", { app }));
  if (c.keys !== undefined) lines.push(t("computer.ask.keys", { keys: c.keys }));
  if (c.menu !== undefined) lines.push(t("computer.ask.menuPath", { menu }));
  if (c.text !== undefined) lines.push(t(c.act === "replace" ? "computer.ask.replaceText" : "computer.ask.text", { text: c.text }));
  if (c.act === "look") lines.push(t("computer.ask.lookNote", { app }));
  return { title, lines: lines.join("\n") };
}
