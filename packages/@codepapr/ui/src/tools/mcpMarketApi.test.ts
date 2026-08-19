import { describe, expect, it } from 'vitest';
import { inferCategories } from './mcpMarketApi';

describe('inferCategories', () => {
  it('does not treat generic HTTP/URL remotes as search', () => {
    expect(inferCategories('docs.example/mcp', 'HTTP API for product docs and URLs')).toEqual(['custom']);
    expect(inferCategories('link.shortener/mcp', 'Shorten a web URL and fetch the page')).toEqual(['custom']);
    expect(inferCategories('browser.tools/mcp', 'Browser automation and scrape helpers')).toEqual(['custom']);
  });

  it('classifies explicit web-search products as search', () => {
    expect(inferCategories('io.github.duckduckgo/mcp', 'DuckDuckGo HTML search')).toContain('search');
    expect(inferCategories('com.tavily/search', 'Tavily web search API')).toContain('search');
    expect(inferCategories('exa.ai/mcp', 'Exa neural search engine')).toContain('search');
  });

  it('still infers database from SQL-family wording', () => {
    expect(inferCategories('io.github.postgres/mcp', 'Query a Postgres database')).toContain('database');
    expect(inferCategories('io.github.postgres/mcp', 'Query a Postgres database')).not.toContain('search');
  });
});
