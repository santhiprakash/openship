import { Command } from "commander";

export const deployCommand = new Command("deploy")
  .description("Deploy the current project (coming soon)")
  .option("--prod", "Deploy to production")
  .option("--preview", "Create a preview deployment")
  .action(() => {
    console.error(
      "openship deploy is not yet implemented. " +
        "Trigger deployments from the dashboard for now.",
    );
    process.exit(1);
  });
