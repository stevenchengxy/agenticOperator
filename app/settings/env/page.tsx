import { redirect } from "next/navigation";

export default function EnvironmentSettingsPage() {
  redirect("/settings/system");
}
