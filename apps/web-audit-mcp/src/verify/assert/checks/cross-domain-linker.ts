import type { CaptureResult, CheckResult, CheckSpec, Status, VerifySpec } from '../../types.js';
import { pass, fail, notVerified } from '../helpers.js';

interface DomainVerdict {
  domain: string;
  status: Status;
  reason?: string;
  destUrl?: string;
}

/**
 * cross_domain_linker — after clicking outbound links to the configured
 * domains, assert the `_gl` linker param is present on the destination URL.
 * Fail if absent for a domain; Not Verified for a domain with no testable link.
 */
export function checkCrossDomainLinker(capture: CaptureResult, _spec: VerifySpec, check: CheckSpec): CheckResult {
  const domains = check.expectedDomains ?? [];
  const linkerActions = capture.actions.filter((a) => a.checkId === check.id && a.kind === 'linker');

  const perDomain: DomainVerdict[] = [];
  let anyFail = false;
  let anyNotVerified = false;

  domains.forEach((domain, i) => {
    const a = linkerActions[i];
    if (!a) {
      anyNotVerified = true;
      perDomain.push({ domain, status: 'Not Verified', reason: 'linker probe was not executed' });
      return;
    }
    if (!a.selectorFound) {
      anyNotVerified = true;
      perDomain.push({ domain, status: 'Not Verified', reason: `no outbound link to ${domain} found to test` });
      return;
    }
    if (a.linkerParamPresent) {
      perDomain.push({ domain, status: 'Pass', ...(a.linkerDestUrl ? { destUrl: a.linkerDestUrl } : {}) });
      return;
    }
    anyFail = true;
    perDomain.push({ domain, status: 'Fail', reason: `_gl linker param absent on destination to ${domain}`, ...(a.linkerDestUrl ? { destUrl: a.linkerDestUrl } : {}) });
  });

  const extra = { domains: perDomain };
  if (anyFail) {
    const failing = perDomain.filter((d) => d.status === 'Fail').map((d) => d.domain);
    return fail(check, `_gl linker param missing on outbound link(s) to ${failing.join(', ')}`, undefined, extra);
  }
  if (anyNotVerified) {
    const nv = perDomain.filter((d) => d.status === 'Not Verified').map((d) => d.domain);
    return notVerified(check, `could not test the cross-domain linker for ${nv.join(', ')} (no link found)`, undefined, extra);
  }
  return pass(check, undefined, extra);
}
