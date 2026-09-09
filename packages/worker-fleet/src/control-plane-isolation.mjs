// @ts-check
/**
 * THE FLEET KEY MUST NOT SIT BESIDE npm's TRANSITIVE DEPENDENCIES — ADR 0012, enforced rather than stated.
 *
 * That ADR's decisive argument is not tidiness: *"the credential able to reconfigure the entire fleet would
 * sit next to the largest supply-chain surface in the system. A compromised transitive dependency in the
 * capture pipeline could reach the SSH key and, from there, twelve Windows boxes that auto-log-in to
 * unlocked desktops."*
 *
 * MEASURED 2026-08-29, on the control plane the ADR describes:
 *
 *     /root/a11y-witness/node_modules   56M, 121 packages
 *     /root/.ssh/a11y-witness_ed25519   the fleet key
 *
 * Exactly the configuration it forbids, on the machine it was written about, for as long as nobody looked.
 * The ADR was accurate about the intent and described a system that did not exist — which is worse than no
 * ADR, because it is read as a guarantee.
 *
 * NOTHING THERE NEEDED THEM, and that is checkable rather than a judgement: `code-version.mjs` — the only
 * thing fleet management imports — has zero bare imports (`node:crypto`, `node:fs`, `node:path`,
 * `node:url`, one sibling), and `deploy.yml` imports it BY PATH for exactly this reason. Removing 56 MB
 * left `codeVersion()` byte-identical at `6645b75480b40003`.
 *
 * So this check exists because the deletion is the easy half. `npm install`, run once on that box by
 * somebody debugging, silently restores the violation — this repo's own rule about anything relying on a
 * human to remember, applied to a security boundary rather than to housekeeping.
 */

/**
 * Whether a control-plane host is carrying what it must not.
 *
 * PURE, so it can be tested without a control plane: the caller does the looking, this decides. The
 * integration half needs a Proxmox host and root, which is precisely the kind of check that never runs.
 *
 * @param {{ hasNodeModules: boolean, hasFleetKey: boolean, packages?: number, isWorkspace?: boolean }} found
 * @returns {{ violated: boolean, why: string }}
 */
export function controlPlaneIsolation({ hasNodeModules, hasFleetKey, packages, isWorkspace = false }) {
  // BOTH, and neither alone. `node_modules` on a box with no fleet key is a lab or a laptop, which is
  // where they belong. A fleet key with no dependencies beside it is the intended configuration. The
  // defect is the ADJACENCY, and reporting either half alone would fire on correct machines -- a guard
  // that cries wolf is one people switch off.
  if (!hasNodeModules || !hasFleetKey) {
    return { violated: false, why: hasFleetKey
      ? "fleet key present, no node_modules beside it — ADR 0012 holds"
      : "no fleet key here, so nothing to isolate it from" };
  }
  const count = packages === undefined ? "" : ` (${packages} packages)`;
  // THE REMEDY DEPENDS ON WHICH MACHINE THIS IS, and getting that wrong makes the guard useless. On a
  // control plane the dependencies are vestigial and go. On a DEVELOPER'S machine they are the whole point
  // of the machine, so the thing that must leave is the KEY -- which is what makes the control plane worth
  // having. Telling a developer to delete their node_modules would be advice nobody can take, and a guard
  // whose advice cannot be taken is one that gets muted.
  const remedy = isWorkspace
    ? "This is a WORKSPACE, so the dependencies belong here and the KEY does not. Dispatch fleet work "
      + "through the control plane instead of holding `a11y-witness_ed25519` beside 100 MB of packages "
      + "you did not audit — see docs/control-plane-plan.md L3."
    : "Nothing on a control plane needs them — `code-version.mjs` has no bare imports and `deploy.yml` "
      + "imports it by path. Remove them: `rm -rf ~/a11y-witness/node_modules` (measured 2026-08-29: "
      + "codeVersion was byte-identical afterwards).";
  return {
    violated: true,
    why: `ADR 0012 VIOLATED: node_modules${count} sits beside the fleet SSH key. A compromised transitive `
      + "dependency here can reach the key that reconfigures every Windows worker, each of which "
      + `auto-logs-in to an unlocked desktop. ${remedy}`,
  };
}
