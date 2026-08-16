import { NextResponse } from 'next/server';
import { readSkillMarkdown } from '@/lib/skills-catalog';

export const dynamic = 'force-dynamic';

/**
 * The full SKILL.md for one real skill. Default: JSON for the reader.
 * ?download=1: the raw file as a text/markdown attachment.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const markdown = readSkillMarkdown(slug);
  if (markdown === null) return NextResponse.json({ error: 'skill not found' }, { status: 404 });
  if (new URL(req.url).searchParams.get('download')) {
    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug.replace(/:/g, '-')}-SKILL.md"`,
      },
    });
  }
  return NextResponse.json({ markdown });
}
