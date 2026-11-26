// The ids of Settings' "Under the hood" pages, read from the text of src/settings/pages.ts (item 128). That list also
// names each page's component, and Node cannot load the components (they import stylesheets), so the Playwright
// helpers read its entries with TypeScript's own parser instead of importing it. src/settings/pages.test.ts holds this
// reading to the list itself. The parser is TypeScript 6.0's API: TypeScript 7.0, the compiler this package type-checks
// with, ships no API, and its release notes point code that parses to @typescript/typescript6 (item 127).
import ts from "@typescript/typescript6";

/** The `id` of every object in `source` whose `where` is "hood", in the order written. */
export function hoodIds(source: string): string[] {
  const sf = ts.createSourceFile("pages.ts", source, ts.ScriptTarget.Latest, true);
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const text = (name: string): string | undefined => {
        const p = node.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText(sf) === name);
        return p && ts.isStringLiteral(p.initializer) ? p.initializer.text : undefined;
      };
      const id = text("id");
      if (id !== undefined && text("where") === "hood") ids.push(id);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ids;
}
