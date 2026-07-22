import { Command } from "commander";
import chalk from "chalk";
import { stop } from "../lib/service";

export const stopCommand = new Command("stop")
  .description("Stop the Openship service (started by `openship up`) — it won't restart or return on reboot")
  .action(() => {
    try {
      const res = stop();
      // No lock cleanup here: the server reclaims a dead-owner PGlite lock itself
      // on the next boot, so a later `openship up` isn't blocked by a stale lock.
      console.log(chalk.green("\n  ✔ Openship stopped.\n") + chalk.dim(`  ${res.detail}\n`));
    } catch (e) {
      console.error(chalk.red(`\n  Couldn't stop the service: ${(e as Error).message}\n`));
      process.exit(1);
    }
  });
