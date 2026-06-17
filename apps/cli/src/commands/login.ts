import { Command } from "commander";

export const loginCommand = new Command("login")
  .description("Authenticate with your Openship account (coming soon)")
  .action(() => {
    console.error(
      "openship login is not yet implemented. " +
        "Sign in via the dashboard for now.",
    );
    process.exit(1);
  });
