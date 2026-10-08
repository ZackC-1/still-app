#!/usr/bin/env python3
"""Compile actual isolated native ordering helpers against a prebuilt StillKit module.

Usage: run-apple-router-repairs.py --products /path/to/SwiftBuild/out/Products/Debug --output /private/tmp/owned-dir
Full app compilation separately verifies SDK/actor/router integration. This is no provider proof.
"""
import argparse
import pathlib
import subprocess

args = argparse.ArgumentParser()
args.add_argument('--products', required=True, type=pathlib.Path)
args.add_argument('--output', required=True, type=pathlib.Path)
options = args.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
manager = (root / 'apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift').read_text()
router = (root / 'apps/apple/Still/Shared (App)/WebBridgeRouter.swift').read_text()
scan = manager[manager.index('@MainActor\nenum AppleOwnershipScan {'):manager.index('@MainActor\nfinal class PurchaseManager {')]
fence = router[router.index('struct AppleAccessRevocationFence {'):router.index('@MainActor\nfinal class WebBridgeRouter {')]
# Critical wiring has no standalone app-target test harness. Guard these exact authority seams
# in addition to the behavioral helper probe; full unsigned target checks cover compilation.
install = router[router.index('case "installAppleAccess":'):router.index('case "observeAppleAccess":')]
observe = router[router.index('case "observeAppleAccess":'):router.index('case "observeAppleLinkAccess":')]
link = router[router.index('case "observeAppleLinkAccess":'):router.index('case "proOffering":')]
assert 'guard MonetizationConfig.paidTierEnabled' in link
assert 'verifiedAppleLinkPurchaseIdentities {' in link and 'permitsInstall(revocationLineage)' in link
assert 'guard MonetizationConfig.paidTierEnabled' in install and 'guard MonetizationConfig.paidTierEnabled' in observe
assert 'self.accessRevocations.permitsInstall(revocationLineage)' in install
assert install.index('permitsInstall(revocationLineage)') < install.index('self.entitlement.installAppleAccess(')
refresh = router[router.index('func refreshReceiptStamp()'):router.index('func handle(')]
assert 'refreshReceiptStatus { self.commitVerifiedRevocation($0) }' in refresh
assert 'accessRevocations.ready ? status : .noSignal' in refresh
receipt = router[router.index('case "receiptStatus":'):router.index('case "attachPurchases":')]
assert 'await self.refreshReceiptStamp()' in receipt
assert 'cancelOnTimeout: true' in manager
assert 'onVerifiedRevocation(revocation)' in manager[manager.index('private static func classifyReceipt'):manager.index('private static func combinedReceipt')]
options.output.mkdir(parents=True, exist_ok=True)
helpers = options.output / 'helpers.swift'
helpers.write_text('import StillKit\n' + scan + '\n' + fence)
binary = options.output / 'probe'
subprocess.run(['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', str(options.output / 'module-cache'),
    '-I', str(options.products), '-L', str(options.products), '-lStillKit', str(helpers),
    str(root / 'tests/access-proof/apple-router-repairs-probe.swift'), '-o', str(binary)], check=True)
subprocess.run([str(binary)], check=True, timeout=15)
print('PASS: paid-route guards, both install lanes, central receipt callback/failure response, timeout cancellation wiring')
