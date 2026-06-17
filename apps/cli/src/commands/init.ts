import { Command } from "commander";

export const initCommand = new Command("init")
  .description("Initialize an Openship project in the current directory (coming soon)")
  .action(() => {
    console.error(
      "openship init is not yet implemented. " +
        "Initialize your project from the dashboard for now.",
    );
    process.exit(1);
  });
