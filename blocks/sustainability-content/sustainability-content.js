export default function decorate(block) {
  block.classList.add('sustainability-content', 'hero', 'content-bottom', 'image-link');

  // Create main wrapper
  const wrapper = document.createElement('div');

  // Create image container
  const imageContainer = document.createElement('div');
  imageContainer.setAttribute('data-valign', 'middle');

  // Move existing picture if it exists
  const picture = block.querySelector('picture');
  if (picture) {
    // Ensure proper image attributes
    const img = picture.querySelector('img');
    if (img) {
      img.width = 1328;
      img.height = 600;
      if (!img.alt) img.alt = '';
    }
    imageContainer.appendChild(picture);
  }

  // Create content container
  const contentContainer = document.createElement('div');
  contentContainer.setAttribute('data-valign', 'middle');

  // Create heading with link
  const heading = document.createElement('h3');
  heading.id = 'repurposed-gems';
  const link = document.createElement('a');
  link.href = '/en/repurposed-gems';
  link.textContent = 'Repurposed gems';
  heading.appendChild(link);

  // Create or use existing paragraph
  const paragraph = block.querySelector('p') || document.createElement('p');
  if (!paragraph.textContent) {
    paragraph.textContent = 'For the latest of H&M Innovation Stories, our design team trains their focus on more sustainably-sourced embellishments.';
  }

  // Assemble the structure
  contentContainer.appendChild(heading);
  contentContainer.appendChild(paragraph);

  wrapper.appendChild(imageContainer);
  wrapper.appendChild(contentContainer);

  // Clear and update block content
  block.textContent = '';
  block.appendChild(wrapper);
}
