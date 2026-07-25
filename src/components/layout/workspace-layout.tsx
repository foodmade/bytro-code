import { WorkspaceRail } from "./workspace-rail";
import { WorkspaceMainView } from "@/components/workspace/workspace-main-view";

export function WorkspaceLayout() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      <WorkspaceRail />
      <WorkspaceMainView />
    </div>
  );
}
