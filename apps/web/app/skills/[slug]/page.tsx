import { notFound } from "next/navigation";
import { SkillEditor } from "@/components/skill-editor";
import { skills } from "@/lib/workspace-data";

type SkillDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return skills.map((skill) => ({ slug: skill.slug }));
}

export default async function SkillDetailPage({ params }: SkillDetailPageProps) {
  const { slug } = await params;
  const skill = skills.find((item) => item.slug === slug);
  if (!skill) notFound();
  return <SkillEditor slug={slug} name={skill.name} category={skill.category} />;
}
