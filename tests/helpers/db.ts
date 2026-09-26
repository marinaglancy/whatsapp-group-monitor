import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from '../../src/config.js'
import { initAccountDb, closeAccountDb } from '../../src/db/account.js'
import { initSharedDb } from '../../src/db/shared.js'

export const TEST_PHONE = '15550000001'

/** Point the app at a throwaway data dir and open shared + account DBs.
 *  config is a mutable object, so tests can redirect dataDir directly. */
export function setupTestDbs() {
  const dir = mkdtempSync(join(tmpdir(), 'wgm-test-'))
  config.dataDir = dir
  initSharedDb()
  initAccountDb(TEST_PHONE)
  return {
    dir,
    cleanup() {
      closeAccountDb()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
