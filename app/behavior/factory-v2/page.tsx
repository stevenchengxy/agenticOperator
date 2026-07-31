// Server wrapper — a production deployment does not serve the agent factory.
// See lib/factory-flag.ts. The client UI lives in ./FactoryV2Page.
import { notFound } from "next/navigation";
import { isFactoryEnabled } from "@/lib/factory-flag";
import FactoryV2Page from "./FactoryV2Page";

export default function Page() {
  if (!isFactoryEnabled()) notFound();
  return <FactoryV2Page />;
}
