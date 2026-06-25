import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <h1 className="text-4xl font-bold text-forest">RecReports</h1>
      <p className="mt-3 max-w-md text-gray-600">
        Daily documentation, compliance reporting, and employee scheduling for recreation
        facilities — in one operations layer.
      </p>
      <Link
        href="/login"
        className="mt-8 rounded-md bg-forest px-6 py-3 font-medium text-white hover:bg-forest-700 focus:outline-none focus:ring-2 focus:ring-forest focus:ring-offset-2"
      >
        Sign in
      </Link>
    </main>
  );
}
