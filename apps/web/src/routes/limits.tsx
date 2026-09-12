import { createFileRoute } from "@tanstack/react-router";

import { UsageLimitsPage } from "../components/usage/UsageLimitsPage";

export const Route = createFileRoute("/limits")({
  component: UsageLimitsPage,
});
