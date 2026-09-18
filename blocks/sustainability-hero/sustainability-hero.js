export default function decorate(block) {
  const picture = block.querySelector('picture');
  if (picture) {
    block.classList.add('sustainability-hero');

    // Create main wrapper
    const wrapper = document.createElement('div');
    const innerWrapper = document.createElement('div');

    // Create content wrapper for heading and arrow
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'content-wrapper';

    // Move heading into content wrapper
    const heading = block.querySelector('h1');
    if (heading) contentWrapper.appendChild(heading);

    // Create arrow element
    const arrow = document.createElement('div');
    arrow.className = 'arrow';
    contentWrapper.appendChild(arrow);

    // Clear and rebuild structure
    block.textContent = '';
    innerWrapper.appendChild(picture);
    innerWrapper.appendChild(contentWrapper);
    wrapper.appendChild(innerWrapper);
    block.appendChild(wrapper);
  }
}
