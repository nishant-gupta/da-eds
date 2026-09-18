/**
 * Decorates the my-hero block
 * @param {Element} block The my-hero block element
 */
export default async function decorate(block) {
  // Check if block is coming from the original hero block
  const isOriginalHero = block.classList.contains('hero');

  if (isOriginalHero) {
    // Transform original hero markup to match our my-hero structure
    block.classList.add('my-hero');
    
    // Handle the heading - transform h3 to h1 if needed
    const heading = block.querySelector('h3');
    if (heading) {
      const headingLink = heading.querySelector('a');
      const headingText = headingLink ? headingLink.textContent : heading.textContent;
      const headingUrl = headingLink ? headingLink.getAttribute('href') : '#';

      // Create new h1 and arrow link
      const h1 = document.createElement('h1');
      h1.textContent = headingText;

      const arrowLink = document.createElement('a');
      arrowLink.classList.add('arrow-link');
      arrowLink.href = headingUrl;
      arrowLink.textContent = '';

      // Replace the h3 with our new elements
      heading.replaceWith(h1);

      // Find the content div and add the arrow link
      const contentDiv = heading.closest('div');
      if (contentDiv) {
        contentDiv.classList.add('my-hero-content');
        contentDiv.appendChild(arrowLink);
      }

      // Add the subtitle class to the paragraph
      const paragraph = block.querySelector('p');
      if (paragraph) {
        paragraph.classList.add('subtitle');
      }
    }
  } else {
    // Handle my-hero blocks created directly with our structure
    const linkElement = block.querySelector('.arrow-link');
    if (linkElement && !linkElement.textContent) {
      linkElement.style.display = 'none';
    }
  }
}
