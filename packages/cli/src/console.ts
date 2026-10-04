// SPDX-License-Identifier: MIT
/**
 * `hh console` (06-interfaces section 1, 07-data-security section 5.2): ask
 * the running daemon for a one-time console login code with the admin token
 * and print the link that signs a browser in. The token itself never reaches
 * the browser; the page exchanges the code for an HttpOnly session cookie.
 */
import { DEFAULT_DAEMON_URL } from "@harnesshub/sdk/local";
import {
  context,
  EXIT,
  localTime,
  output,
  parse,
  positionals,
  report,
  UsageError,
  write,
} from "./admin.js";

const USAGE = `Usage: hh console [--url URL] [--data-dir DIR] [--json]

Print a link that signs a browser on this computer in to the console of the
running daemon. The link works once, within 60 seconds; run hh console again
for a new one.

--url       the daemon's address, or a development server that forwards to it
            (default ${DEFAULT_DAEMON_URL})
--data-dir  the daemon's data directory, which holds admin.token (default ./data)
--json      print {"url", "expiresAt"}`;

/**
 * Run `hh console` (`argv` starts with `console`).
 *
 * @returns 0 with the link on stdout; 2 for a usage error; 3 when the daemon
 *   or its admin token is unavailable; 6 when the token is refused (06
 *   section 5).
 */
export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(1);
  if (args.includes("--help")) {
    write(USAGE);
    return EXIT.ok;
  }
  try {
    const { values, positionals: given } = parse(args, {});
    const ctx = context(values);
    positionals(given, []);
    const base = new URL(
      typeof values.url === "string" ? values.url : DEFAULT_DAEMON_URL,
    );
    const link = await (await ctx.client()).auth.createConsoleLink();
    // The code goes in the fragment, which browsers do not send to servers.
    const url = `${base.origin}/#login=${link.code}`;
    output(ctx, { url, expiresAt: link.expiresAt }, () =>
      [
        url,
        "",
        `Open this link in a browser on this computer to sign in to the console. It works once, until ${localTime(link.expiresAt)}.`,
      ].join("\n"),
    );
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return EXIT.usage;
    }
    return report(error, args.includes("--json"));
  }
}
