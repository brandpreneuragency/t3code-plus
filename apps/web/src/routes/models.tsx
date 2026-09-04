import { createFileRoute } from "@tanstack/react-router";

import { ModelCataloguePage } from "../components/models/ModelCataloguePage";

export const Route = createFileRoute("/models")({
  component: ModelCataloguePage,
});
