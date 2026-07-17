// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const articles = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().optional().default(''),
    category: z.string().nullable().optional(),
    subCategory: z.string().nullable().optional(),
    articleType: z.string().optional(),
    country: z.string().optional().default('global'),
    publishDate: z.union([z.string(), z.date()]).optional(),
    lastVerified: z.union([z.string(), z.date()]).optional(),
    readingTime: z.union([z.number(), z.string()]).optional(),
    tags: z.array(z.any()).optional().default([]),
    keywords: z.array(z.any()).optional().default([]),
    dataSources: z.array(z.any()).optional().default([]),
    ogImage: z.string().optional().default('/og-images/default.png'),
    draft: z.boolean().optional().default(false),
  }).passthrough(),  // accept extra fields from DSPro
});

export const collections = { articles };
