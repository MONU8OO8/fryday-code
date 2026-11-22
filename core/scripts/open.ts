/**
 * `npm run open`: the same as `fryday-code open` (src/cli/open.ts).
 *
 *   npm run open            open the default browser
 *   npm run open -- --print just print the link
 */

import { main } from '../src/cli/open';

main().then((code) => process.exit(code));
