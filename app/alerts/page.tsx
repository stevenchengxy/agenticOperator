import { redirect } from "next/navigation";

// /alerts was the old P1–P4 alert page. It is superseded by the unified
// 消息通知 (notification) center at /notifications.
export default function AlertsPage() {
  redirect("/notifications");
}
