/**
 * Marketplace DOM selectors. Replace with stable selectors from your DOM inspection.
 * Keys are used by the scraper; values are Playwright-compatible CSS strings.
 */
module.exports = {
  listingAnchor: 'a[href*="/marketplace/item/"]',
  title: '[data-testid="marketplace-pdp-title"], span.x1lliihq, h1',
  price: '[data-testid="marketplace-pdp-price"], span.x193iq5w',
  image: 'img[src*="scontent"], img[src*="fbcdn"], img[alt]',
};
