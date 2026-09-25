import { ChatsSidebar } from "@/components/chats/sidebar";
import { SidebarLayoutWrapper } from "@/components/sidebar-layout-wrapper";
import { requireSetup } from "@/lib/server-wiki";

// Layout = chrome (sidebar + off-canvas drawer) plus the setup gate.
//
// The gate is duplicated in each page under /chats on purpose: `redirect()`
// called from a layout can be swallowed (the request answers 200 and the page
// renders anyway) while the same call from a page redirects correctly. The
// layout keeps the early check; the pages are what actually enforce it.
export default async function ChatsLayout({ children }: { children: React.ReactNode }) {
  await requireSetup("chat");
  return (
    <SidebarLayoutWrapper sidebar={<ChatsSidebar />} triggerLabel="打开对话列表">
      {children}
    </SidebarLayoutWrapper>
  );
}
