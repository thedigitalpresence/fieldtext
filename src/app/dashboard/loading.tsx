// Skeleton shown while the dashboard's queries run — no more frozen blank frame.
export default function DashboardLoading() {
  return (
    <main className="mx-auto max-w-3xl animate-pulse space-y-7 px-4 py-6 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-gray-200" />
        <div className="space-y-2">
          <div className="h-5 w-44 rounded bg-gray-200" />
          <div className="h-3 w-56 rounded bg-gray-100" />
        </div>
      </div>
      <div className="h-28 rounded-2xl bg-gray-200/70" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-gray-100" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="h-64 rounded-2xl bg-gray-100" />
        <div className="h-64 rounded-2xl bg-gray-100" />
      </div>
    </main>
  );
}
