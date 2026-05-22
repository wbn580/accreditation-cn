// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const articles = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum([
      'university', 'agent', 'migration', 'broker',
      'legal', 'medical', 'insights', 'glossary', 'faq', 'news',
    ]),
    subCategory: z.string().optional(),
    articleType: z.enum([
      'overview', 'history', 'criteria', 'accredited_list',
      'how_to_apply', 'faq', 'comparison', 'case_studies',
      'insight', 'glossary_term', 'faq_answer',
    ]),
    country: z.string().default('global'),
    publishDate: z.string(),
    lastVerified: z.string(),
    readingTime: z.number().optional(),
    tags: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
    dataSources: z.array(z.object({
      name: z.string(),
      url: z.string().optional(),
      fetchedDate: z.string().optional(),
    })).default([]),
    ogImage: z.string().default('/og-images/default.svg'),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articles };
