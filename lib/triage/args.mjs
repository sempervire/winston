/** The command line of scripts/triage-issue.mjs. */

export const DEFAULT_MAX = 5

const FLAGS = {
  '--issue': (o, v) => { o.issue = /^\d+$/.test(v ?? '') ? Number(v) : NaN },
  '--sweep': (o) => { o.sweep = true },
  '--opened': (o) => { o.opened = true },
  '--dry-run': (o) => { o.dryRun = true },
  '--max': (o, v) => { o.max = /^\d+$/.test(v ?? '') ? Number(v) : NaN },
}
const TAKES_VALUE = new Set(['--issue', '--max'])

export function parseArgs(argv) {
  const o = { issue: null, sweep: false, opened: false, dryRun: false, max: DEFAULT_MAX }
  for (let i = 0; i < argv.length; i++) {
    const flag = FLAGS[argv[i]]
    if (!flag) throw new Error(`unknown argument: ${argv[i]}`)
    flag(o, TAKES_VALUE.has(argv[i]) ? argv[++i] : undefined)
  }
  if (o.sweep === (o.issue !== null)) throw new Error('pass exactly one of --issue <n> and --sweep')
  if (o.issue !== null && !(o.issue >= 1)) throw new Error('--issue takes an issue number')
  if (o.opened && o.issue === null) throw new Error('--opened applies only to --issue <n>')
  if (!(Number.isInteger(o.max) && o.max >= 1)) throw new Error('--max takes a positive count')
  return o
}
