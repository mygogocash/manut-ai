// Where a file the person asked for is saved. The activity log's "Download CSV" ends here.
//
// The desktop shell cannot save one yet. Its capability file (src-tauri/capabilities/default.json) grants only
// `dialog:allow-open`, so the page may open a picker but not a save dialog, and no shell command writes a file to a path the
// person chose (the commands that write do so under ~/.manut, for the app's own files). Until the shell has both, saving
// answers "not yet" and the page says so, instead of dropping the file somewhere the person did not pick or pretending
// it was exported. When the shell grows a save command, this is the one place that calls it.
export type SaveResult = "saved" | "not_yet";

export async function saveCsv(_name: string, _text: string): Promise<SaveResult> {
  return "not_yet";
}
