import { useStore } from '../../stores';
import { ActivityPanel } from '../ActivityPanel';
import { AutomationPanel } from '../AutomationPanel';
import { BridgePanel } from '../BridgePanel';
import { SkillsPanel } from '../SkillsPanel';
import { PreviewPanel } from '../PreviewPanel';
import { PluginPageView } from '../plugin/PluginPageView';
import { MainContent } from '../../MainContent';
import { ChatPage } from './ChatPage';
import { WorkspaceCompanionRail } from './WorkspaceCompanionRail';

function PluginPage({ pluginId }: { pluginId: string }) {
  return (
    <div className="plugin-page-shell">
      <PluginPageView pluginId={pluginId} />
    </div>
  );
}

export function AppPages() {
  const currentTab = useStore(s => s.currentTab === 'channels' ? 'chat' : s.currentTab);
  const isPluginTab = typeof currentTab === 'string' && currentTab.startsWith('plugin:');

  return (
    <>
      <MainContent>
        {currentTab === 'chat' && <ChatPage />}
        {isPluginTab && <PluginPage pluginId={currentTab.slice(7)} />}
        <ActivityPanel />
        <AutomationPanel />
        <SkillsPanel />
        <BridgePanel />
      </MainContent>

      {currentTab === 'chat' && <PreviewPanel />}
      <WorkspaceCompanionRail />
    </>
  );
}
