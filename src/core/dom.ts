export const el = {
  $(sel: string, root: ParentNode | Document = document) {
    return root.querySelector(sel);
  },
  $all(sel: string, root: ParentNode | Document = document) {
    return Array.from(root.querySelectorAll(sel));
  }
};
