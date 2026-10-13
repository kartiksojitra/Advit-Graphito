import AirlockHero from "@/components/ui/airlock-spaceship-hero";

export default function App() {
  return (
    <main className="w-full min-h-screen bg-[#05070d] text-[#f2f4f8]">
      <AirlockHero
        title="ADV!T GRAPHITO"
        logoSrc="/logo.png"
        tagline={"WEBSITE UNDER CONSTRUCTION\nA New Creative Galaxy Is About to Unfold"}
        scrollHint="SCROLL"
        theme="vacuum"
        scrubDistance={3200}
        holdDistance={1100}
      />
    </main>
  );
}
