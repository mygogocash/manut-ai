// The options a check or a read may have (item 116): each program's known flags and values, and `knownOptions`, which asks whether a line's options are all of them.
// Its own file because the lists are long and are changed by reading a program's own `--help`, not by changing code.
import { takesWord } from "./verdict";

// ---- the options a check or a read may have (item 116) ------------------------------------------------------------
//
// Four reviews each found an option the deny-lists above did not know that makes a check or a read write a file, run a
// program the line names, open a debugger on an address, or fetch and install. So a check, and a read of the programs
// below, is now read from a list of the options each program is known to take harmlessly: any other option makes the
// line `unknown`, which asks. Each list was read from the program's own `--help` on the Mac that built it (vitest 3.2.7,
// tsc 5.9.3, playwright, pytest 9.0.2, mypy 1.19.1, ruff 0.15.8, pip 21.2.4, uv 0.11.6, cargo, shellcheck, actionlint) or,
// for one not installed there, from its own documentation (jest, eslint, prettier, mocha, pylint, go test, turbo). A
// program with no list here, or one whose documentation was not read, takes no option at all. An option that is only
// harmless for most values (`--reporter`, `--config`) is still checked by `checkOptions`, and every value is checked as a
// path is.

/** A program's options: `flags` take no value, `values` take one (joined by `=`, joined to a short one, or the next word),
 *  and `changes` make the step a change. A long one is written `--name`, compared without letter case, `-` and `_`, and
 *  taken back with `--no-name` when it is a flag; a short one is `-x`, bundled with others. `long1` reads `-name` as a
 *  long option, as Go's flags do. `optional` are the options of `values` whose value is optional, from the program's own
 *  help (item 120): the program takes one only joined to it, never the next word. No value option takes a next word that
 *  starts with `-`: a program whose value is optional reads that word as an option of its own, and one whose value is
 *  required takes it as the value or refuses to start, so reading it as an option only ever asks more. */
interface Known {
  flags?: string;
  values?: string;
  changes?: string;
  optional?: string;
  long1?: true;
}

const optKey = (w: string) => (w.startsWith("--") ? `--${w.slice(2).toLowerCase().replace(/[-_]/g, "")}` : w);

const setOf = (list = "", long1 = false) => new Set(list.split(/\s+/).filter(Boolean).map((w) => optKey(long1 && !w.startsWith("--") ? `-${w}` : w)));

const PIP_COMMON = "-h --help --isolated -v --verbose -q --quiet --no-input --no-cache-dir --disable-pip-version-check --no-color --no-python-version-warning";

const UV_COMMON = "-h --help -q --quiet -v --verbose -n --no-cache --color --offline --no-progress --no-config";

const VITEST =
  "-w --watch --silent --hideSkippedTests --coverage --isolate --globals --fileParallelism --passWithNoTests --logHeapUsage --allowOnly --expandSnapshotDiff --disableConsoleIntercept --typecheck --printConsoleTrace --includeTaskLocation --run --color --clearScreen -h --help -v --version";

const VITEST_VALUES = "-r --root -c --config -t --testNamePattern --dir --reporter --mode --workspace --pool --maxWorkers --minWorkers --environment --shard --changed --testTimeout --hookTimeout --bail --retry --exclude --project --slowTestThreshold --teardownTimeout --maxConcurrency";

/** vitest 3.2.7's `--help` writes these with `[value]`: cac over mri takes a next word for them only when it is no option. */
const VITEST_OPTIONAL = "--changed";

const TSC_FLAGS =
  "--noEmit --pretty --strict --skipLibCheck --skipDefaultLibCheck --listFiles --listFilesOnly --explainFiles --diagnostics --extendedDiagnostics --traceResolution --noErrorTruncation --showConfig --version --help --all " +
  "--allowJs --checkJs --resolveJsonModule --esModuleInterop --allowSyntheticDefaultImports --forceConsistentCasingInFileNames --isolatedModules --isolatedDeclarations --verbatimModuleSyntax --erasableSyntaxOnly " +
  "--allowUnreachableCode --allowUnusedLabels --alwaysStrict --exactOptionalPropertyTypes --noFallthroughCasesInSwitch --noImplicitAny --noImplicitOverride --noImplicitReturns --noImplicitThis " +
  "--noPropertyAccessFromIndexSignature --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --strictBindCallApply --strictBuiltinIteratorReturn --strictFunctionTypes --strictNullChecks " +
  "--strictPropertyInitialization --useUnknownInCatchVariables --noUncheckedSideEffectImports --experimentalDecorators --emitDecoratorMetadata --useDefineForClassFields --noLib --noResolve";

const TSC_VALUES = "-p --project --target --module --moduleResolution --lib --jsx --types --moduleDetection --locale";

const CARGO_CHECK =
  "--future-incompat-report -v --verbose -q --quiet -h --help --workspace --all --lib --bins --examples --tests --benches --all-targets --all-features --no-default-features -r --release --ignore-rust-version --locked --offline --frozen --keep-going";

const CARGO_VALUES = "--message-format --color -p --package --exclude --bin --example --test --bench -F --features -j --jobs --profile --target";

/** cargo's `--help` writes these with `[<NAME>]`: with none it lists the targets. */
const CARGO_OPTIONAL = "-p --package --bin --example --test --bench --target";

export const KNOWN: Record<string, Known> = {
  vitest: { flags: VITEST, values: VITEST_VALUES, changes: "-u --update", optional: VITEST_OPTIONAL },
  "vitest list": { flags: `${VITEST} --filesOnly`, values: VITEST_VALUES, optional: VITEST_OPTIONAL },
  tsc: { flags: TSC_FLAGS, values: TSC_VALUES },
  "vue-tsc": { flags: TSC_FLAGS, values: TSC_VALUES },
  "playwright test": { flags: "--fail-on-flaky-tests --forbid-only --fully-parallel --headed --last-failed --list --no-deps --pass-with-no-tests --quiet --shuffle -x -h --help", values: "-c --config --browser -g --grep -G --grep-invert --global-timeout -j --workers --max-failures --project --repeat-each --reporter --retries --shard --timeout", changes: "-u --update-snapshots" },
  pytest: {
    flags: "--markers -x --exitfirst --strict-config --strict-markers --strict --fixtures --fixtures-per-test --runxfail --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise --sw-skip --cache-show -v --verbose --no-header --no-summary --no-fold-skipped --force-short-summary -q --quiet -l --showlocals --no-showlocals --xfail-tb --full-trace --collect-only --co --noconftest --keep-duplicates --collect-in-virtualenv --continue-on-collection-errors --doctest-modules --doctest-ignore-import-errors --doctest-continue-on-failure --setup-only --setup-show --setup-plan --disable-plugin-autoload --disable-warnings -s -V --version -h --help",
    values: "-k -m --maxfail --durations --durations-min --verbosity -r --tb --show-capture --color --code-highlight -W --ignore --ignore-glob --deselect --doctest-glob --import-mode --capture --assert --log-level --log-cli-level --log-format --log-date-format",
  },
  mypy: {
    flags:
      "-h --help -v --verbose -V --version --warn-unused-configs --no-namespace-packages --ignore-missing-imports --follow-untyped-imports --no-site-packages --no-silence-site-packages --disallow-any-expr --disallow-any-decorated --disallow-any-explicit --disallow-any-generics --disallow-any-unimported --disallow-subclassing-any --disallow-untyped-calls --disallow-untyped-defs --disallow-incomplete-defs --check-untyped-defs --disallow-untyped-decorators --implicit-optional --no-strict-optional --warn-redundant-casts --warn-unused-ignores --no-warn-no-return --warn-return-any --warn-unreachable --report-deprecated-as-note --allow-untyped-globals --allow-redefinition --allow-redefinition-new --no-implicit-reexport --strict-equality --strict-equality-for-none --strict-bytes --extra-checks --strict --show-error-context --show-column-numbers --show-error-end --hide-error-codes --show-error-code-links --pretty --no-color-output --no-error-summary --show-absolute-path --no-incremental --show-traceback --scripts-are-modules --explicit-package-bases --exclude-gitignore",
    values: "-O --follow-imports --python-version --platform --always-true --always-false --untyped-calls-exclude --deprecated-calls-exclude --disable-error-code --enable-error-code --exclude -m -p",
  },
  "ruff check": {
    flags: "--show-fixes --diff --ignore-noqa --preview --statistics --show-files --show-settings -h --help --respect-gitignore --force-exclude -n --no-cache -e --exit-zero --exit-non-zero-on-fix -v --verbose -q --quiet -s --silent --isolated",
    values: "--output-format --target-version --extension --select --ignore --extend-select --per-file-ignores --extend-per-file-ignores --fixable --unfixable --extend-fixable --exclude --extend-exclude --color",
    changes: "--fix --unsafe-fixes --fix-only --add-noqa",
  },
  "ruff format": { flags: "--check --diff --preview -h --help -n --no-cache --exit-non-zero-on-format --respect-gitignore --force-exclude -v --verbose -q --quiet -s --silent --isolated", values: "--extension --target-version --output-format --exclude --line-length --range --color" },
  "ruff version": {},
  jest: {
    flags: "--ci --clearMocks --collectTests --colors --coverage --collectCoverage --detectOpenHandles --errorOnDeprecated -e --expand --forceExit --help --injectGlobals --listTests --logHeapUsage --noStackTrace -o --onlyChanged -f --onlyFailures --passWithNoTests --randomize --resetMocks --restoreMocks -i --runInBand --runTestsByPath --showSeed --silent --testLocationInResults --useStderr --verbose -v --version --watch --watchAll --workerThreads",
    values: "-b --bail --changedSince --collectCoverageFrom --coverageProvider --maxConcurrency -w --maxWorkers --seed --selectProjects --shard --testMatch -t --testNamePattern --testPathIgnorePatterns --testPathPatterns --testTimeout",
    changes: "-u --updateSnapshot",
    // jest's CLI documentation writes `--bail[=<n>]`
    optional: "-b --bail",
  },
  mocha: {
    flags: "--allow-uncaught -A --async-only -b --bail --check-leaks --color -c --colors --delay --diff --dry-run --exit --fail-zero --forbid-only --forbid-pending --full-trace --inline-diffs -i --invert --list-interfaces --list-reporters -C --no-colors -p --parallel --posix-exit-codes --recursive --sort -S -h --help -V --version",
    values: "--global --globals -j --jobs --retries -s --slow -t --timeout --timeouts -u --ui --extension --ignore --exclude -f --fgrep -g --grep",
  },
  eslint: {
    flags: "--no-config-lookup --no-ignore --quiet --color --no-color --no-inline-config --report-unused-disable-directives --report-unused-inline-configs --cache --no-error-on-unmatched-pattern --exit-on-fatal-error --no-warn-ignored --pass-on-no-patterns --debug -h --help -v --version --stats --fix-dry-run",
    values: "--ext --global --rule --ignore-pattern --max-warnings -f --format --report-unused-disable-directives-severity --cache-strategy --fix-type --concurrency",
    changes: "--fix",
  },
  prettier: { flags: "--check -c --list-different -l --no-config --no-editorconfig --with-node-modules --ignore-unknown -u --no-error-on-unmatched-pattern --cache --debug-check", values: "--ignore-path --config-precedence --log-level --find-config-path", changes: "--write -w" },
  pylint: { flags: "-h --help --version --list-msgs --list-msgs-enabled", values: "--disable -d --enable -j --ignore --msg-template --recursive --source-roots" },
  black: { flags: "--check --diff -q --quiet" },
  isort: { flags: "--check --check-only -c --diff -q --quiet" },
  // documentation not read for these: they take no option, and any asks
  ava: {}, tap: {}, pyright: {}, flake8: {}, knip: {}, depcheck: {}, cspell: {}, stylelint: {}, markdownlint: {}, hadolint: {}, cypress: {}, "cypress run": {},
  "biome check": {}, "biome lint": {}, "biome format": {}, "biome ci": {}, shellcheck: { flags: "-a --check-sourced -C --color --list-optional --norc -V --version --help", values: "-i --include -e --exclude --extended-analysis -f --format -o --enable -s --shell -S --severity -W --wiki-link-count" },
  actionlint: { long1: true, flags: "-color -no-color -oneline -verbose -version -debug", values: "-ignore -format" },
  "go test": { long1: true, flags: "-json -cover -failfast -fullpath -short -v -benchmem", values: "-bench -benchtime -count -covermode -coverpkg -cpu -list -parallel -run -shuffle -skip -timeout -vet" },
  "go vet": { long1: true },
  "cargo test": { flags: `${CARGO_CHECK} --no-run --no-fail-fast --doc`, values: CARGO_VALUES, optional: CARGO_OPTIONAL },
  "cargo check": { flags: CARGO_CHECK, values: CARGO_VALUES, optional: CARGO_OPTIONAL },
  "cargo bench": { flags: CARGO_CHECK, values: CARGO_VALUES, optional: CARGO_OPTIONAL },
  "cargo clippy": { flags: `${CARGO_CHECK} --no-deps`, values: CARGO_VALUES, changes: "--fix", optional: CARGO_OPTIONAL },
  "pip list": { flags: `${PIP_COMMON} -o --outdated -u --uptodate -e --editable -l --local --user --pre --not-required --exclude-editable --include-editable --no-index`, values: "--format --exclude" },
  "pip show": { flags: `${PIP_COMMON} -f --files` },
  "pip freeze": { flags: `${PIP_COMMON} -l --local --user --all --exclude-editable`, values: "--exclude" },
  "pip check": { flags: PIP_COMMON },
  "uv pip list": { flags: `${UV_COMMON} -e --editable --exclude-editable --outdated --strict`, values: "--exclude --format" },
  "uv pip show": { flags: UV_COMMON },
  "uv pip freeze": { flags: UV_COMMON },
  "uv pip tree": { flags: UV_COMMON },
  "uv pip check": { flags: UV_COMMON },
  // the words a package manager hands to a script nobody has read: options harmless in every runner a test script is
  // likely to run (vitest, jest, mocha, playwright, bun's own), and the ones that update snapshots
  "": { flags: "--run --coverage --silent --verbose --passWithNoTests --runInBand", values: "-t --testNamePattern --reporter --pool --project --shard --testTimeout --maxWorkers --environment --config --mode", changes: "-u --update --updateSnapshot" },
  // turbo hands the words after `--` to the task, read as a script's are
  turbo: { values: "--filter -F" },
};

/** What a program's own options make of a check or a read, by its list in `KNOWN`: null when each is one it takes
 *  harmlessly, `change` when one changes files, `unknown` for any other (a program with no list knows none). With
 *  `handed`, words after `--` are read too, as the options of whatever the script runs. */
export function knownOptions(key: string, args: readonly string[], handed = false): "change" | "unknown" | null {
  const k = KNOWN[key] ?? {};
  const flags = setOf(k.flags, k.long1);
  const values = setOf(k.values, k.long1);
  const changes = setOf(k.changes, k.long1);
  const optional = setOf(k.optional, k.long1);
  /** Whether the word after a value option at `i` is its value (item 120): never one that starts with `-`, and never for one
   *  whose value is optional. */
  const takesNext = (i: number, n: string) => !optional.has(n) && takesWord(args[i + 1]);
  let change = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--") {
      if (handed) continue;
      break;
    }
    if (!w.startsWith("-") || w === "-") continue;
    if (w.startsWith("--") || k.long1) {
      const n = optKey(`--${w.replace(/^--?/, "").split("=")[0]}`);
      if (flags.has(n) || (n.startsWith("--no") && flags.has(`--${n.slice(4)}`))) continue;
      if (values.has(n) || optional.has(n)) {
        if (!w.includes("=") && takesNext(i, n)) i++;
        continue;
      }
      if (changes.has(n)) {
        change = true;
        continue;
      }
      return "unknown";
    }
    for (let j = 1; j < w.length; j++) {
      const c = `-${w[j]}`;
      if (flags.has(c)) continue;
      if (changes.has(c)) {
        change = true;
        continue;
      }
      if (values.has(c) || optional.has(c)) {
        if (j === w.length - 1 && takesNext(i, c)) i++;
        break;
      }
      return "unknown";
    }
  }
  return change ? "change" : null;
}
