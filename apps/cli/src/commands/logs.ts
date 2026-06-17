import { Command } from "commander";

export const logsCommand = new Command("logs")
  .description("Stream deployment logs (coming soon)")
  .argument("[deploymentId]", "Deployment ID (defaults to latest)")
  .action(() => {
    console.error(
      "openship logs is not yet implemented. " +
        "View deployment logs in the dashboard for now.",
    );
    process.exit(1);
  });
