export default function ChatsIndexPage() {
  return (
    <main className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-md text-center text-sm text-muted-foreground">
        <p className="text-lg font-medium text-foreground">未选择对话。</p>
        <p className="mt-2">
          从左侧列表中选择一段对话，或点击 <strong>+ 新建对话</strong> 开始新对话。
        </p>
      </div>
    </main>
  );
}
