import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page" id="main-content">
      <h1>404 Not Found</h1>
      <p className="lede">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <div style={{ textAlign: "center", marginTop: "2rem" }}>
        <img
          src="/ui/elements/404page/404photo.png"
          alt="Lost and confused"
          style={{ maxWidth: "100%", height: "auto" }}
        />
      </div>
      <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
        <Link href="/">Go back home</Link>
      </div>
    </main>
  );
}
