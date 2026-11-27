// Reading a command Kit asks to run, before it runs: what kind of step it is (member-grants' `KitAction`), the paths it
// names outside the project, the rule "Always allow in this project" would keep for it, and what it does in words.
// Kit's dial (`kitDecide` in @manut/member-grants) decides from this whether Kit may run it alone, must ask, or is
// stopped. Pure: no file is looked at and nothing runs.
//
// The reading is careful rather than clever. A command it cannot read in advance (a substitution, a pipe into a
// shell, a program it does not know, a script of the project's own with an unknown name) is `unknown`, which asks at
// every level and keeps no rule. A command built from several takes its strictest part. Paths are compared as
// written, after `.` and `..` are taken out: nothing is looked up on disk, so a link that leads out is not seen, and
// `~` is outside unless the home folder is known.
export { type Where, type Say, type Rule, type ReadCommand } from "./command/types";
export { insideProject, folderOf } from "./command/paths";
export { guardedPath } from "./command/protected";
export { IN_GIT_DIR } from "./command/programs";
export { readCommand, foldersAfter, scriptRun } from "./command/whole";
export { ruleMatches, ruleCovers, ruleText } from "./command/rules";
