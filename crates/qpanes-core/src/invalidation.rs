//! Compare native canonical identifiers without decoding display labels or
//! applying a guessed case-folding rule to a potentially case-sensitive volume.
use crate::{FsError, NativePath};
use std::path::{Component, PathBuf};

fn native(path: &NativePath) -> Result<PathBuf, FsError> {
    if path.0.len() > 131072 {
        return Err(FsError::invalid_path());
    }
    let path = path.to_path()?;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(FsError::invalid_path());
    }
    Ok(path)
}

/// Inputs are identifiers emitted by native listings/operation intents. Listing
/// canonicalization owns filesystem normalization; this pure comparison retains
/// native components/case and also works after an old subtree no longer exists.
/// `Path::starts_with` compares whole native components, never string prefixes.
pub fn classify_operation_invalidation(
    paths: &[NativePath],
    directories: &[NativePath],
    subtrees: &[NativePath],
) -> Result<Vec<bool>, FsError> {
    if paths.len() > 4 || directories.len() > 256 || subtrees.len() > 128 {
        return Err(FsError::invalid_path());
    }
    let directories: Vec<_> = directories.iter().map(native).collect::<Result<_, _>>()?;
    let subtrees: Vec<_> = subtrees.iter().map(native).collect::<Result<_, _>>()?;
    paths
        .iter()
        .map(|path| {
            let path = native(path)?;
            Ok(directories.contains(&path) || subtrees.iter().any(|root| path.starts_with(root)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    fn id(path: &str) -> NativePath {
        NativePath::from_path(Path::new(path))
    }
    #[cfg(unix)]
    #[test]
    fn exact_and_subtree_matches_respect_native_components_and_case() {
        let paths = [
            "/tmp/source",
            "/tmp/source/child",
            "/tmp/source-other",
            "/tmp/Source/child",
        ]
        .map(id);
        assert_eq!(
            classify_operation_invalidation(&paths, &[id("/tmp/parent")], &[id("/tmp/source")])
                .unwrap(),
            vec![true, true, false, false]
        );
        assert_eq!(
            classify_operation_invalidation(&[id("/tmp/source/child")], &[id("/tmp/source")], &[])
                .unwrap(),
            vec![false]
        );
        assert_eq!(
            classify_operation_invalidation(&[id("/tmp/source")], &[id("/tmp/source")], &[])
                .unwrap(),
            vec![true]
        );
        assert_eq!(
            classify_operation_invalidation(&[id("/")], &[], &[id("/")]).unwrap(),
            vec![true]
        );
    }
    #[cfg(unix)]
    #[test]
    fn non_utf8_ancestry_is_lossless() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        let root = PathBuf::from(OsString::from_vec(b"/tmp/tree-\xff".to_vec()));
        let other = PathBuf::from(OsString::from_vec(b"/tmp/tree-\xfe".to_vec()));
        let paths = [
            NativePath::from_path(&root.join("child")),
            NativePath::from_path(&other.join("child")),
        ];
        assert_eq!(
            classify_operation_invalidation(&paths, &[], &[NativePath::from_path(&root)]).unwrap(),
            vec![true, false]
        );
    }
    #[cfg(windows)]
    #[test]
    fn windows_canonical_drive_and_unc_roots_keep_native_boundaries() {
        let paths = [
            r"\\?\C:\tree\child",
            r"\\?\C:\tree-other",
            r"\\?\D:\tree\child",
            r"\\?\C:\Tree\child",
        ]
        .map(id);
        assert_eq!(
            classify_operation_invalidation(&paths, &[], &[id(r"\\?\C:\tree")]).unwrap(),
            vec![true, false, false, false]
        );
        assert_eq!(
            classify_operation_invalidation(
                &[
                    id(r"\\?\UNC\server\share\child"),
                    id(r"\\?\UNC\server\share-other")
                ],
                &[],
                &[id(r"\\?\UNC\server\share")]
            )
            .unwrap(),
            vec![true, false]
        );
    }
    #[test]
    fn invalid_native_paths_and_oversized_requests_are_rejected() {
        assert!(classify_operation_invalidation(&[id("relative")], &[], &[]).is_err());
        let absolute = std::env::temp_dir().join("qpanes-invalid/../sibling");
        assert!(
            classify_operation_invalidation(&[NativePath::from_path(&absolute)], &[], &[]).is_err()
        );
        assert!(
            classify_operation_invalidation(
                &vec![NativePath::from_path(&std::env::temp_dir()); 5],
                &[],
                &[]
            )
            .is_err()
        );
    }
}
