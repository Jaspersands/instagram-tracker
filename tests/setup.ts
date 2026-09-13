import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Point the dashboard's auth lookup at a file that does not exist.
 *
 * buildServer() defaults to data/auth.json, so once a developer sets a real
 * password every server test starts returning 401 and the suite fails on a
 * machine-local condition that has nothing to do with the code. Tests that care
 * about auth pass an explicit path of their own.
 */
process.env.IG_AUTH = join(tmpdir(), 'ig-tests-auth-must-not-exist.json');
